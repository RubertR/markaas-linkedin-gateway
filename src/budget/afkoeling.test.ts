import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { registreerAccount, vindAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { inAfkoeling, mogelijkeOpbouwNaAfkoeling, startAfkoeling } from './afkoeling.ts';
import { laadLimieten } from './limits.ts';

async function versAccount() {
  const h = await verseDatabaseMetMigraties();
  const client = await maakClient(h.db, { naam: 'ACME BV', slug: 'acme' });
  const account = await registreerAccount(h.db, {
    clientId: client.id,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  return { ...h, accountId: account.id };
}

describe('startAfkoeling', () => {
  it('zet afkoeling_tot op nu + duur_uren en opbouw_factor terug naar 0.5', async () => {
    const h = await versAccount();
    try {
      const l = await laadLimieten();
      const nu = new Date('2026-10-01T12:00:00Z');
      await startAfkoeling(h.db, h.accountId, nu, l.afkoeling);
      const account = await vindAccount(h.db, h.accountId);
      assert.ok(account);
      assert.ok(account.afkoelingTot);
      assert.equal(
        account.afkoelingTot.toISOString(),
        new Date('2026-10-03T12:00:00Z').toISOString(),
      );
      assert.equal(account.opbouwFactor, 0.5);
    } finally {
      await h.close();
    }
  });

  it('is idempotent: tweede trigger verlengt de afkoeling vanaf de nieuwe trigger', async () => {
    const h = await versAccount();
    try {
      const l = await laadLimieten();
      await startAfkoeling(h.db, h.accountId, new Date('2026-10-01T12:00:00Z'), l.afkoeling);
      await startAfkoeling(h.db, h.accountId, new Date('2026-10-01T15:00:00Z'), l.afkoeling);
      const account = await vindAccount(h.db, h.accountId);
      assert.ok(account?.afkoelingTot);
      assert.equal(
        account.afkoelingTot.toISOString(),
        new Date('2026-10-03T15:00:00Z').toISOString(),
      );
    } finally {
      await h.close();
    }
  });
});

describe('inAfkoeling', () => {
  it('geen afkoeling_tot = niet in afkoeling', () => {
    assert.equal(
      inAfkoeling({ afkoelingTot: null }, new Date('2026-10-01T12:00:00Z')),
      false,
    );
  });

  it('nu < afkoeling_tot = in afkoeling', () => {
    assert.equal(
      inAfkoeling(
        { afkoelingTot: new Date('2026-10-03T12:00:00Z') },
        new Date('2026-10-02T12:00:00Z'),
      ),
      true,
    );
  });

  it('nu >= afkoeling_tot = niet in afkoeling', () => {
    assert.equal(
      inAfkoeling(
        { afkoelingTot: new Date('2026-10-03T12:00:00Z') },
        new Date('2026-10-03T12:00:01Z'),
      ),
      false,
    );
  });
});

describe('mogelijkeOpbouwNaAfkoeling', () => {
  it('tijdens 7 dagen na afkoeling: geen opbouw toegestaan', async () => {
    const l = await laadLimieten();
    const afkoelingTot = new Date('2026-10-03T12:00:00Z');
    // 2 dagen na afkoeling (binnen 7-dagenvenster) → nog niet.
    assert.equal(
      mogelijkeOpbouwNaAfkoeling(
        { afkoelingTot },
        new Date('2026-10-05T12:00:00Z'),
        l.afkoeling,
      ),
      false,
    );
  });

  it('precies 7 dagen na afkoeling_tot: opbouw mag weer', async () => {
    const l = await laadLimieten();
    const afkoelingTot = new Date('2026-10-03T12:00:00Z');
    assert.equal(
      mogelijkeOpbouwNaAfkoeling(
        { afkoelingTot },
        new Date('2026-10-10T12:00:00Z'),
        l.afkoeling,
      ),
      true,
    );
  });

  it('nooit in afkoeling geweest: opbouw mag', async () => {
    const l = await laadLimieten();
    assert.equal(
      mogelijkeOpbouwNaAfkoeling(
        { afkoelingTot: null },
        new Date('2026-10-10T12:00:00Z'),
        l.afkoeling,
      ),
      true,
    );
  });
});
