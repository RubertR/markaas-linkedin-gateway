import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { maakClient } from '../register/clients.ts';
import { markeerAccountGekoppeld, registreerAccount } from '../register/accounts.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import {
  keurActieGoed,
  maakActie,
  vindActie,
  zetActieStatus,
} from './acties.ts';

async function versAccount(opties: { gekoppeld?: boolean } = {}) {
  const h = await verseDatabaseMetMigraties();
  const client = await maakClient(h.db, { naam: 'ACME', slug: 'acme' });
  const account = await registreerAccount(h.db, {
    clientId: client.id,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  if (opties.gekoppeld !== false) {
    await markeerAccountGekoppeld(h.db, account.id, 'unipile-acc-1');
  }
  return { ...h, accountId: account.id };
}

describe('maakActie', () => {
  it('maakt een actie met status "draft" en bewaart de payload als JSON', async () => {
    const h = await versAccount();
    try {
      const actie = await maakActie(h.db, {
        accountId: h.accountId,
        type: 'invite',
        payload: { providerId: 'ACo123', message: 'Hoi!' },
      });
      assert.equal(actie.status, 'draft');
      assert.equal(actie.type, 'invite');
      assert.deepEqual(actie.payload, { providerId: 'ACo123', message: 'Hoi!' });
      assert.equal(actie.goedgekeurdDoor, null);
      assert.equal(actie.goedgekeurdOp, null);
      assert.equal(actie.geplandOp, null);
      assert.ok(actie.aangemaaktOp instanceof Date);
    } finally {
      await h.close();
    }
  });

  it('kan voor search/profile direct status "approved" krijgen zonder goedkeuring', async () => {
    const h = await versAccount();
    try {
      const actie = await maakActie(h.db, {
        accountId: h.accountId,
        type: 'search',
        payload: { keywords: 'ceo' },
        directApproved: true,
      });
      assert.equal(actie.status, 'approved');
    } finally {
      await h.close();
    }
  });

  it('weigert directApproved voor invite/message/inmail', async () => {
    const h = await versAccount();
    try {
      await assert.rejects(
        maakActie(h.db, {
          accountId: h.accountId,
          type: 'invite',
          payload: {},
          directApproved: true,
        }),
        /goedkeuring/i,
      );
    } finally {
      await h.close();
    }
  });
});

describe('keurActieGoed', () => {
  it('zet status "draft" → "approved" en noteert door-wie en wanneer', async () => {
    const h = await versAccount();
    try {
      const actie = await maakActie(h.db, {
        accountId: h.accountId,
        type: 'invite',
        payload: { providerId: 'ACo123' },
      });
      const nu = new Date('2026-10-06T10:00:00Z');
      const goedgekeurd = await keurActieGoed(h.db, actie.id, 'rubert@rietkerk.org', nu);
      assert.equal(goedgekeurd.status, 'approved');
      assert.equal(goedgekeurd.goedgekeurdDoor, 'rubert@rietkerk.org');
      assert.equal(goedgekeurd.goedgekeurdOp?.toISOString(), '2026-10-06T10:00:00.000Z');
    } finally {
      await h.close();
    }
  });

  it('weigert goedkeuren van een actie die al "done" of "rejected" is', async () => {
    const h = await versAccount();
    try {
      const actie = await maakActie(h.db, {
        accountId: h.accountId,
        type: 'invite',
        payload: {},
      });
      await zetActieStatus(h.db, actie.id, 'rejected', { reden: 'test' });
      await assert.rejects(
        keurActieGoed(h.db, actie.id, 'rubert'),
        /status/i,
      );
    } finally {
      await h.close();
    }
  });
});

describe('vindActie', () => {
  it('geeft null bij onbekende id', async () => {
    const h = await versAccount();
    try {
      const actie = await vindActie(h.db, '00000000-0000-0000-0000-000000000000');
      assert.equal(actie, null);
    } finally {
      await h.close();
    }
  });
});

describe('zetActieStatus', () => {
  it('vernieuwt status, reden, geplandOp, uitgevoerdOp en unipileResponse in één query', async () => {
    const h = await versAccount();
    try {
      const actie = await maakActie(h.db, {
        accountId: h.accountId,
        type: 'invite',
        payload: {},
      });
      const uitgevoerd = new Date('2026-10-06T10:05:00Z');
      await zetActieStatus(h.db, actie.id, 'done', {
        reden: null,
        uitgevoerdOp: uitgevoerd,
        unipileResponse: { invitation_id: 'inv-1' },
      });
      const na = await vindActie(h.db, actie.id);
      assert.ok(na);
      assert.equal(na.status, 'done');
      assert.equal(na.reden, null);
      assert.equal(na.uitgevoerdOp?.toISOString(), uitgevoerd.toISOString());
      assert.deepEqual(na.unipileResponse, { invitation_id: 'inv-1' });
    } finally {
      await h.close();
    }
  });

  it('zet alleen de meegegeven velden; andere kolommen blijven staan', async () => {
    const h = await versAccount();
    try {
      const actie = await maakActie(h.db, {
        accountId: h.accountId,
        type: 'invite',
        payload: {},
      });
      await keurActieGoed(h.db, actie.id, 'rubert', new Date('2026-10-06T09:00:00Z'));
      await zetActieStatus(h.db, actie.id, 'queued', {
        reden: 'dagbudget bereikt',
        geplandOp: new Date('2026-10-07T08:30:00Z'),
      });
      const na = await vindActie(h.db, actie.id);
      assert.ok(na);
      assert.equal(na.status, 'queued');
      assert.equal(na.reden, 'dagbudget bereikt');
      assert.equal(na.goedgekeurdDoor, 'rubert'); // niet overschreven
      assert.equal(na.geplandOp?.toISOString(), '2026-10-07T08:30:00.000Z');
    } finally {
      await h.close();
    }
  });
});
