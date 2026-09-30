import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Backend } from '../db/backend.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { maakClient, vindClientBijSlug } from './clients.ts';

let db: Backend;
let close: () => Promise<void>;

before(async () => {
  const opgezet = await verseDatabaseMetMigraties();
  db = opgezet.db;
  close = opgezet.close;
});

after(async () => {
  await close();
});

beforeEach(async () => {
  await db.query('delete from clients');
});

describe('clients — maakClient', () => {
  it('maakt een client met naam en slug, actief standaard true', async () => {
    const client = await maakClient(db, { naam: 'IPknowledge', slug: 'ipknowledge' });
    assert.ok(client.id);
    assert.equal(client.naam, 'IPknowledge');
    assert.equal(client.slug, 'ipknowledge');
    assert.equal(client.actief, true);
    assert.ok(client.aangemaaktOp instanceof Date);
  });

  it('gooit een Nederlandse fout bij een dubbele slug', async () => {
    await maakClient(db, { naam: 'Aqua', slug: 'aqua' });
    await assert.rejects(
      maakClient(db, { naam: 'Aqua BV', slug: 'aqua' }),
      (err: Error) => {
        assert.match(err.message, /slug/i);
        assert.match(err.message, /bestaat al|duplicaat|dubbele/i);
        return true;
      },
    );
  });
});

describe('clients — vindClientBijSlug', () => {
  it('geeft de client terug bij een bekende slug', async () => {
    const gemaakt = await maakClient(db, { naam: 'ICT Media', slug: 'ict-media' });
    const gevonden = await vindClientBijSlug(db, 'ict-media');
    assert.ok(gevonden);
    assert.equal(gevonden?.id, gemaakt.id);
  });

  it('geeft null terug bij een onbekende slug', async () => {
    const gevonden = await vindClientBijSlug(db, 'onbekend');
    assert.equal(gevonden, null);
  });
});
