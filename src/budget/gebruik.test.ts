import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { maakClient } from '../register/clients.ts';
import { registreerAccount } from '../register/accounts.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import {
  telGebruikOpDag,
  telGebruikOverDagen,
  verhoogGebruik,
} from './gebruik.ts';

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

describe('verhoogGebruik', () => {
  it('maakt een rij aan voor een nieuwe (account, type, dag) en telt bij een tweede call op', async () => {
    const h = await versAccount();
    try {
      await verhoogGebruik(h.db, h.accountId, 'invite', '2026-10-01');
      await verhoogGebruik(h.db, h.accountId, 'invite', '2026-10-01', 3);
      const telling = await telGebruikOpDag(h.db, h.accountId, 'invite', '2026-10-01');
      assert.equal(telling, 4);
    } finally {
      await h.close();
    }
  });

  it('verschillende dagen tellen niet mee bij elkaar', async () => {
    const h = await versAccount();
    try {
      await verhoogGebruik(h.db, h.accountId, 'message', '2026-10-01', 5);
      await verhoogGebruik(h.db, h.accountId, 'message', '2026-10-02', 2);
      assert.equal(await telGebruikOpDag(h.db, h.accountId, 'message', '2026-10-01'), 5);
      assert.equal(await telGebruikOpDag(h.db, h.accountId, 'message', '2026-10-02'), 2);
    } finally {
      await h.close();
    }
  });

  it('verschillende actietypes delen geen teller', async () => {
    const h = await versAccount();
    try {
      await verhoogGebruik(h.db, h.accountId, 'invite', '2026-10-01', 2);
      await verhoogGebruik(h.db, h.accountId, 'message', '2026-10-01', 7);
      assert.equal(await telGebruikOpDag(h.db, h.accountId, 'invite', '2026-10-01'), 2);
      assert.equal(await telGebruikOpDag(h.db, h.accountId, 'message', '2026-10-01'), 7);
    } finally {
      await h.close();
    }
  });

  it('weigert een niet-positief aantal', async () => {
    const h = await versAccount();
    try {
      await assert.rejects(
        verhoogGebruik(h.db, h.accountId, 'invite', '2026-10-01', 0),
        /positief/,
      );
      await assert.rejects(
        verhoogGebruik(h.db, h.accountId, 'invite', '2026-10-01', -1),
        /positief/,
      );
    } finally {
      await h.close();
    }
  });
});

describe('telGebruikOpDag', () => {
  it('geeft 0 terug als er nog geen rij is', async () => {
    const h = await versAccount();
    try {
      const telling = await telGebruikOpDag(h.db, h.accountId, 'invite', '2026-10-01');
      assert.equal(telling, 0);
    } finally {
      await h.close();
    }
  });
});

describe('telGebruikOverDagen', () => {
  it('somt de tellingen over een reeks dagen', async () => {
    const h = await versAccount();
    try {
      await verhoogGebruik(h.db, h.accountId, 'invite', '2026-10-20', 3);
      await verhoogGebruik(h.db, h.accountId, 'invite', '2026-10-21', 5);
      await verhoogGebruik(h.db, h.accountId, 'invite', '2026-10-22', 1);
      // Dag buiten venster telt niet mee.
      await verhoogGebruik(h.db, h.accountId, 'invite', '2026-10-19', 100);

      const som = await telGebruikOverDagen(h.db, h.accountId, 'invite', [
        '2026-10-20',
        '2026-10-21',
        '2026-10-22',
      ]);
      assert.equal(som, 9);
    } finally {
      await h.close();
    }
  });

  it('geeft 0 bij een lege dagen-reeks', async () => {
    const h = await versAccount();
    try {
      const som = await telGebruikOverDagen(h.db, h.accountId, 'invite', []);
      assert.equal(som, 0);
    } finally {
      await h.close();
    }
  });
});
